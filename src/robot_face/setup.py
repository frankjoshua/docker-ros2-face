from setuptools import find_packages, setup

package_name = 'robot_face'

setup(
    name=package_name,
    version='0.1.0',
    packages=find_packages(exclude=['test']),
    package_data={package_name: [
        'web/index.html', 'web/face/*.js', 'web/face/*.css', 'web/face/*.json', 'web/face/looks/*.js',
        'web/vendor/*',
    ]},
    data_files=[
        ('share/ament_index/resource_index/packages', ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
    ],
    install_requires=['setuptools'],
    zip_safe=False,
    tests_require=['pytest'],
    maintainer='Joshua Frank',
    maintainer_email='josh@tesseractmobile.com',
    description='Browser-rendered robot face driven by ROS 2 topics',
    license='Apache-2.0',
    entry_points={
        'console_scripts': [
            'face_node = robot_face.face_node:main',
        ],
    },
)
